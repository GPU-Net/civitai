import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';

export const ModelSearchIndexSortBy = [
  'models:metrics.weightedRating:desc',
  'models:metrics.downloadCount:desc',
  'models:metrics.favoriteCount:desc',
  'models:metrics.commentCount:desc',
  'models:createdAt:desc',
] as const;

const ModelDefaultSortBy = ModelSearchIndexSortBy[0];

const modelSearchParamsSchema = searchParamsSchema
  .extend({
    sortBy: z.enum(ModelSearchIndexSortBy),
    baseModel: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    modelType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    checkpointType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export type ModelSearchParams = z.output<typeof modelSearchParamsSchema>;

export const modelInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const modelSearchIndexResult = modelSearchParamsSchema.safeParse(QS.parse(location.search));

    const modelSearchIndexData: ModelSearchParams | Record<string, string[]> =
      modelSearchIndexResult.success ? modelSearchIndexResult.data : {};

    return { models: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const models: ModelSearchParams = routeState.models as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'version.baseModel': models.baseModel,
      type: models.modelType,
      checkpointType: models.checkpointType,
      'tags.name': models.tags,
      'user.username': models.users,
    });

    const { query, sortBy } = models;

    return {
      models: {
        sortBy: sortBy ?? ModelDefaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const baseModel = uiState.models.refinementList?.['version.baseModel'];
    const modelType = uiState.models.refinementList?.['type'];
    const checkpointType = uiState.models.refinementList?.['checkpointType'];
    const tags = uiState.models.refinementList?.['tags.name'];
    const users = uiState.models.refinementList?.['user.username'];
    const sortBy = (uiState.models.sortBy as ModelSearchParams['sortBy']) || ModelDefaultSortBy;
    const { query } = uiState.models;

    const state: ModelSearchParams = {
      baseModel,
      modelType,
      checkpointType,
      users,
      tags,
      sortBy,
      query,
    };

    return {
      models: state,
    };
  },
};