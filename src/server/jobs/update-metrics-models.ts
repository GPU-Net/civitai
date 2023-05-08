import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';

const log = createLogger('update-metrics', 'blue');

const METRIC_LAST_UPDATED_MODELS_KEY = 'last-metrics-update-models';

export const updateMetricsModelJob = createJob(
  'update-metrics-models',
  '*/1 * * * *',
  async () => {
    // Get the last time this ran from the KeyValue store
    // --------------------------------------
    const dates = await dbWrite.keyValue.findMany({
      where: {
        key: { in: [METRIC_LAST_UPDATED_MODELS_KEY] },
      },
    });
    const lastUpdateDate = new Date(
      (dates.find((d) => d.key === METRIC_LAST_UPDATED_MODELS_KEY)?.value as number) ?? 0
    );
    const updateModelMetrics = async (since: Date) => {
      const clickhouseSince = dayjs(since).format('YYYY-MM-DD');

      async function updateVersionDownloadMetrics() {
        const affectedModelVersionsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT modelVersionId
            FROM resourceReviews
            WHERE createdDate >= '${clickhouseSince}'
          `,
          format: 'JSONEachRow',
        });

        const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
          {
            modelVersionId: number;
          }
        ];

        for (const affectedModelVersion of affectedModelVersions) {
          const modelVersionDownloadCountsResponse = await clickhouse?.query({
            query: `
              SELECT
                  COUNT(DISTINCT if(mve.time >= subtractDays(now(), 1), coalesce(mve.userId, mve.ip), null)) AS downloads24Hours,
                  COUNT(DISTINCT if(mve.time >= subtractDays(now(), 7), coalesce(mve.userId, mve.ip), null)) AS downloads1Week,
                  COUNT(DISTINCT if(mve.time >= subtractMonths(now(), 1), coalesce(mve.userId, mve.ip), null)) AS downloads1Month,
                  COUNT(DISTINCT if(mve.time >= subtractYears(now(), 1), coalesce(mve.userId, mve.ip), null)) AS downloads1Year,
                  COUNT(DISTINCT mve.ip) AS downloadsAll
              FROM modelVersionEvents mve
              WHERE mve.modelVersionId = ${affectedModelVersion.modelVersionId}
              AND mve.type = 'Download';
            `,
            format: 'JSONEachRow',
          });

          const modelVersionDownloadCounts = (await modelVersionDownloadCountsResponse?.json()) as [
            {
              downloads24Hours: string;
              downloads1Week: string;
              downloads1Month: string;
              downloads1Year: string;
              downloadsAll: string;
            }
          ];

          if (modelVersionDownloadCounts.length > 0) {
            const modelVersionDownloadCount = modelVersionDownloadCounts[0];
            await dbWrite.$executeRaw`
              INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
              VALUES 
                (${affectedModelVersion.modelVersionId}, 'Day', ${parseInt(
              modelVersionDownloadCount.downloads24Hours
            )}, 0, 0, 0, 0),
                (${affectedModelVersion.modelVersionId}, 'Week', ${parseInt(
              modelVersionDownloadCount.downloads1Week
            )}, 0, 0, 0, 0),
                (${affectedModelVersion.modelVersionId}, 'Month', ${parseInt(
              modelVersionDownloadCount.downloads1Month
            )}, 0, 0, 0, 0),
                (${affectedModelVersion.modelVersionId}, 'Year', ${parseInt(
              modelVersionDownloadCount.downloads1Year
            )}, 0, 0, 0, 0),
                (${affectedModelVersion.modelVersionId}, 'AllTime', ${parseInt(
              modelVersionDownloadCount.downloadsAll
            )}, 0, 0, 0, 0)
              ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "downloadCount" = EXCLUDED."downloadCount";
            `;
          }
        }
      }

      async function updateVersionRatingMetrics() {
        const affectedModelVersionsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT modelVersionId
            FROM resourceReviews
            WHERE createdDate >= '${clickhouseSince}'
          `,
          format: 'JSONEachRow',
        });

        const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
          {
            modelVersionId: number;
          }
        ];

        const affectedModelVersionsJson = JSON.stringify(
          affectedModelVersions.map((x) => x.modelVersionId)
        );

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              rr."modelVersionId",
              tf.timeframe,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', 1, 0)
                  END
              ), 0),
              COALESCE(AVG(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN rating
                      WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', rating, NULL)
                      WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', rating, NULL)
                      WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', rating, NULL)
                      WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', rating, NULL)
                  END
              ), 0),
              0,
              0
          FROM (
              SELECT
                  r."userId",
                  r."modelVersionId",
                  MAX(r.rating) rating,
                  MAX(r."createdAt") AS created_at
              FROM "ResourceReview" r
              JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
              WHERE r.exclude = FALSE
              AND r."tosViolation" = FALSE
              AND r."modelVersionId" = ANY (SELECT json_array_elements(${affectedModelVersionsJson}::json)::text::integer)
              GROUP BY r."userId", r."modelVersionId"
          ) rr
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY rr."modelVersionId", tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating;
        `;
      }

      async function updateVersionFavoriteMetrics() {
        const affectedModelsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT modelId
            FROM modelEngagements
            WHERE createdDate >= '${clickhouseSince}'
            AND type = 'Favorite'
          `,
          format: 'JSONEachRow',
        });

        const effectedModels = (await affectedModelsResponse?.json()) as [
          {
            modelId: number;
          }
        ];

        const affectedModelsJson = JSON.stringify(effectedModels.map((x) => x.modelId));

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              mv."id",
              tf.timeframe,
              0,
              0,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(f."createdAt" >= NOW() - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(f."createdAt" >= NOW() - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(f."createdAt" >= NOW() - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(f."createdAt" >= NOW() - interval '1 day', 1, 0)
                  END
              ), 0),
              0
          FROM (
              SELECT
                  f."modelId",
                  f."createdAt"
              FROM "ModelEngagement" f
              WHERE f.type = 'Favorite'
              AND f."modelId" = ANY (SELECT json_array_elements(${affectedModelsJson}::json)::text::integer)
          ) f
          JOIN "ModelVersion" mv ON f."modelId" = mv."modelId"
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY mv.id, tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "favoriteCount" = EXCLUDED."favoriteCount";
        `;
      }

      async function updateVersionCommentMetrics() {
        const affectedModelsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT entityId AS modelId
            FROM comments
            WHERE createdDate >= '${clickhouseSince}'
            AND type = 'Model'
          `,
          format: 'JSONEachRow',
        });

        const affectedModels = (await affectedModelsResponse?.json()) as [
          {
            modelId: number;
          }
        ];

        const affectedModelsJson = JSON.stringify(affectedModels.map((x) => x.modelId));

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              mv."id",
              tf.timeframe,
              0,
              0,
              0,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(c."createdAt" >= NOW() - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(c."createdAt" >= NOW() - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(c."createdAt" >= NOW() - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(c."createdAt" >= NOW() - interval '1 day', 1, 0)
                  END
              ), 0)
          FROM (
              SELECT
                  c."modelId",
                  c."createdAt"
              FROM "Comment" c
              WHERE c."tosViolation" = false
              AND c."modelId" = ANY (SELECT json_array_elements(${affectedModelsJson}::json)::text::integer)
          ) c
          JOIN "ModelVersion" mv ON c."modelId" = mv."modelId"
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY mv.id, tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "commentCount" = EXCLUDED."commentCount";
        `;
      }

      async function updateModelMetrics() {
        await dbWrite.$executeRaw`
          INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", rating, "ratingCount", "favoriteCount", "commentCount")
          SELECT mv."modelId", mvm.timeframe, SUM(mvm."downloadCount"), COALESCE(SUM(mvm.rating * mvm."ratingCount") / NULLIF(SUM(mvm."ratingCount"), 0), 0), SUM(mvm."ratingCount"), SUM(mvm."favoriteCount"), SUM(mvm."commentCount")
          FROM "ModelVersionMetric" mvm
          JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
          GROUP BY mv."modelId", mvm.timeframe
          ON CONFLICT ("modelId", timeframe) DO UPDATE
              SET  "downloadCount" = EXCLUDED."downloadCount", rating = EXCLUDED.rating, "ratingCount" = EXCLUDED."ratingCount", "favoriteCount" = EXCLUDED."favoriteCount", "commentCount" = EXCLUDED."commentCount";
        `;
      }

      await updateVersionDownloadMetrics();
      await updateVersionRatingMetrics();
      await updateVersionFavoriteMetrics();
      await updateVersionCommentMetrics();

      // Update model metrics after all version metrics have been computed
      await updateModelMetrics();
    };

    const refreshModelRank = async () => {
      await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelRank_New";`);
      await dbWrite.$executeRawUnsafe(
        `CREATE TABLE "ModelRank_New" AS SELECT * FROM "ModelRank_Live";`
      );
      await dbWrite.$executeRawUnsafe(
        `ALTER TABLE "ModelRank_New" ADD CONSTRAINT "pk_ModelRank_New" PRIMARY KEY ("modelId")`
      );

      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`TRUNCATE TABLE "ModelRank"`),
        dbWrite.$executeRawUnsafe(`INSERT INTO "ModelRank" SELECT * FROM "ModelRank_New"`),
      ]);
      dbWrite.$executeRawUnsafe(`VACUUM "ModelRank"`);
    };

    const refreshVersionModelRank = async () => {
      await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelVersionRank_New";`);
      await dbWrite.$executeRawUnsafe(
        `CREATE TABLE "ModelVersionRank_New" AS SELECT * FROM "ModelVersionRank_Live";`
      );
      await dbWrite.$executeRawUnsafe(
        `ALTER TABLE "ModelVersionRank_New" ADD CONSTRAINT "pk_ModelVersionRank_New" PRIMARY KEY ("modelVersionId")`
      );
      await dbWrite.$executeRawUnsafe(
        `CREATE INDEX "ModelVersionRank_New_idx" ON "ModelVersionRank_New"("modelVersionId")`
      );

      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelVersionRank";`),
        dbWrite.$executeRawUnsafe(
          `ALTER TABLE "ModelVersionRank_New" RENAME TO "ModelVersionRank";`
        ),
        dbWrite.$executeRawUnsafe(
          `ALTER TABLE "ModelVersionRank" RENAME CONSTRAINT "pk_ModelVersionRank_New" TO "pk_ModelVersionRank";`
        ),
        dbWrite.$executeRawUnsafe(
          `ALTER INDEX "ModelVersionRank_New_idx" RENAME TO "ModelVersionRank_idx";`
        ),
      ]);
    };

    const currentDate = new Date();

    // If this is the first metric update of the day, recompute all recently affected metrics
    // -------------------------------------------------------------------
    if (lastUpdateDate.getDate() !== currentDate.getDate()) {
      // Pick a refresh start that at least includes the last 24 hours plus some
      const refreshStartDate = dayjs(lastUpdateDate)
        .subtract(1, 'day')
        .subtract(1, 'hour')
        .toDate();
      await updateModelMetrics(refreshStartDate);
      log('Refreshed model metrics');
    } else {
      // Otherwise we can update the metrics from our last update-date
      await updateModelMetrics(lastUpdateDate);
      log('Updated model metrics');
    }

    // Update the last update time
    // --------------------------------------------
    await dbWrite?.keyValue.upsert({
      where: { key: METRIC_LAST_UPDATED_MODELS_KEY },
      create: { key: METRIC_LAST_UPDATED_MODELS_KEY, value: currentDate.getTime() },
      update: { value: currentDate.getTime() },
    });

    // Update rank views
    // --------------------------------------------
    await refreshVersionModelRank();
    await refreshModelRank();
  },
  {
    lockExpiration: 10 * 60,
  }
);
