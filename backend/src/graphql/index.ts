/**
 * Mounts the GraphQL endpoint on an Express router.
 *
 * Endpoint: POST /api/graphql
 *
 * Uses `graphql-http` (spec-compliant, no Apollo overhead).
 * Introspection is disabled in production to reduce attack surface.
 *
 * Security:
 *  - Depth limit: rejects queries nested deeper than MAX_DEPTH (default 6,
 *    configurable via GRAPHQL_MAX_DEPTH env var)
 *  - Complexity limit: rejects queries whose cost score exceeds MAX_COMPLEXITY
 *    (default 100, configurable via GRAPHQL_MAX_COMPLEXITY env var). List
 *    fields are scored at LIST_FIELD_COST (default 10) to account for fan-out;
 *    scalar/object fields cost 1 each.
 *  - No mutations exposed — all writes go through the existing REST layer
 *  - Rate limiting is inherited from the global Express rate limiter in index.ts
 */

import { Router } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { buildSchema, GraphQLError, parse, validate } from "graphql";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";

const MAX_DEPTH = parseInt(process.env.GRAPHQL_MAX_DEPTH ?? "6", 10);
const MAX_COMPLEXITY = parseInt(process.env.GRAPHQL_MAX_COMPLEXITY ?? "100", 10);
// Fields returning lists are more expensive due to N-row fan-out.
const LIST_FIELD_COST = parseInt(process.env.GRAPHQL_LIST_FIELD_COST ?? "10", 10);

/** Fields known to return lists (fan-out multiplier applied). */
const LIST_FIELDS = new Set([
  "tokens", "burnRecords", "streams", "proposals", "votes", "campaigns",
]);

function maxQueryDepth(node: any, depth = 0): number {
  if (!node || typeof node !== "object") return depth;
  if (node.selectionSet?.selections) {
    return Math.max(
      ...node.selectionSet.selections.map((s: any) => maxQueryDepth(s, depth + 1))
    );
  }
  return depth;
}

/**
 * Recursively compute a cost score for a selection set node.
 * Each field costs 1; list fields cost LIST_FIELD_COST to account for N-row
 * fan-out. The cost accumulates across all nested selections.
 */
function queryComplexity(node: any): number {
  if (!node || typeof node !== "object") return 0;
  if (!node.selectionSet?.selections) return 1;

  let cost = 0;
  for (const selection of node.selectionSet.selections) {
    const fieldName: string | undefined = selection.name?.value;
    const fieldCost = fieldName && LIST_FIELDS.has(fieldName) ? LIST_FIELD_COST : 1;
    cost += fieldCost + queryComplexity(selection);
  }
  return cost;
}

export const schema = buildSchema(typeDefs);

/** Flat rootValue merging all resolver namespaces for graphql-http. */
const rootValue = {
  ...resolvers.Query,
  // Field resolvers for nested types are handled inside the Query resolvers
  // by fetching relations lazily (see resolvers.ts Token.burnRecords etc.)
};

const router = Router();

router.all(
  "/",
  createHandler({
    schema,
    rootValue,
    onSubscribe(_req, params) {
      // Disable introspection in production
      if (
        process.env.NODE_ENV === "production" &&
        typeof params.query === "string" &&
        params.query.includes("__schema")
      ) {
        return [new GraphQLError("Introspection is disabled in production")];
      }

      if (typeof params.query === "string") {
        try {
          const doc = parse(params.query);
          const errors = validate(schema, doc);
          if (errors.length) return errors;

          const depth = Math.max(...doc.definitions.map((def: any) => maxQueryDepth(def)));
          if (depth > MAX_DEPTH) {
            return [
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${MAX_DEPTH}`
              ),
            ];
          }

          const complexity = doc.definitions.reduce(
            (sum: number, def: any) => sum + queryComplexity(def),
            0
          );
          if (complexity > MAX_COMPLEXITY) {
            return [
              new GraphQLError(
                `Query complexity ${complexity} exceeds maximum allowed budget of ${MAX_COMPLEXITY}`
              ),
            ];
          }
        } catch {
          return [new GraphQLError("Failed to parse query")];
        }
      }

      return undefined;
    },
  })
);

export default router;
