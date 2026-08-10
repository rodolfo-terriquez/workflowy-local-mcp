export interface LlmDocItem {
  n: string;
  d?: string;
  l?: string;
  x?: number;
  c?: LlmDocItem[];
}

export interface LlmDocOperation {
  op: "insert" | "update" | "delete" | "move";
  under?: string;
  after?: string;
  items?: LlmDocItem[];
  position?: "top" | "bottom";
  ref?: string;
  to?: {
    n?: string;
    d?: string;
    l?: string;
    x?: number;
  };
}

export interface PublicApiEditPlan {
  backend: "public_v1";
  operation: "insert" | "update" | "delete" | "move" | "complete" | "uncomplete";
  path: string;
  method: "POST" | "DELETE";
  body?: Record<string, unknown>;
}

export interface LlmDocEditPlan {
  backend: "llm_doc";
  reason: string;
}

export type DocEditPlan = PublicApiEditPlan | LlmDocEditPlan;

const PUBLIC_LINE_TYPES = new Set([
  "todo",
  "h1",
  "h2",
  "h3",
  "bullets",
  "code",
  "quote",
]);

function llmDoc(reason: string): LlmDocEditPlan {
  return { backend: "llm_doc", reason };
}

function publicLayoutMode(lineType: string): string {
  switch (lineType) {
    case "code":
      return "code-block";
    case "quote":
      return "quote-block";
    default:
      return lineType;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Choose the narrowest safe write backend before making any network request.
 *
 * Public v1 handles ordinary single-node CRUD and materializes Calendar
 * destinations such as `today` on demand. The LLM document endpoint remains
 * responsible for grouped edits and richer document structures so the server
 * never decomposes one requested edit into several partially successful calls.
 */
export function planDocEdit(operations: LlmDocOperation[]): DocEditPlan {
  if (operations.length !== 1) {
    return llmDoc("grouped edits require the document API");
  }

  const operation = operations[0];
  if (!operation) {
    return llmDoc("no operation was provided");
  }

  switch (operation.op) {
    case "insert": {
      if (!isNonEmptyString(operation.under) || operation.after !== undefined) {
        return llmDoc("insert-after and non-parent inserts require the document API");
      }
      if (!operation.items || operation.items.length !== 1) {
        return llmDoc("multi-item inserts require the document API");
      }

      const item = operation.items[0];
      if (!item || !isNonEmptyString(item.n)) {
        return llmDoc("the public API requires one named item");
      }
      if (item.c && item.c.length > 0) {
        return llmDoc("nested inserts require the document API");
      }
      if (item.x !== undefined) {
        return llmDoc("completed inserts require the document API");
      }
      if (item.l !== undefined && !PUBLIC_LINE_TYPES.has(item.l)) {
        return llmDoc("the requested line type requires the document API");
      }

      return {
        backend: "public_v1",
        operation: "insert",
        path: "/nodes",
        method: "POST",
        body: {
          parent_id: operation.under,
          name: item.n,
          ...(item.d !== undefined ? { note: item.d } : {}),
          ...(item.l !== undefined ? { layoutMode: publicLayoutMode(item.l) } : {}),
          position: operation.position ?? "top",
        },
      };
    }

    case "update": {
      if (!isNonEmptyString(operation.ref) || !operation.to) {
        return llmDoc("the update is missing a node reference or values");
      }

      const { n, d, l, x } = operation.to;
      const hasContentUpdate = n !== undefined || d !== undefined || l !== undefined;
      if (x !== undefined) {
        if (hasContentUpdate || (x !== 0 && x !== 1)) {
          return llmDoc("mixed content and completion updates require the document API");
        }
        const action = x === 1 ? "complete" : "uncomplete";
        return {
          backend: "public_v1",
          operation: action,
          path: `/nodes/${encodeURIComponent(operation.ref)}/${action}`,
          method: "POST",
        };
      }
      if (!hasContentUpdate) {
        return llmDoc("the update has no values");
      }
      if (l !== undefined && !PUBLIC_LINE_TYPES.has(l)) {
        return llmDoc("the requested line type requires the document API");
      }

      return {
        backend: "public_v1",
        operation: "update",
        path: `/nodes/${encodeURIComponent(operation.ref)}`,
        method: "POST",
        body: {
          ...(n !== undefined ? { name: n } : {}),
          ...(d !== undefined ? { note: d } : {}),
          ...(l !== undefined ? { layoutMode: publicLayoutMode(l) } : {}),
        },
      };
    }

    case "delete":
      if (!isNonEmptyString(operation.ref)) {
        return llmDoc("the delete is missing a node reference");
      }
      return {
        backend: "public_v1",
        operation: "delete",
        path: `/nodes/${encodeURIComponent(operation.ref)}`,
        method: "DELETE",
      };

    case "move":
      if (!isNonEmptyString(operation.ref) || !isNonEmptyString(operation.under)) {
        return llmDoc("the move is missing a node reference or destination");
      }
      return {
        backend: "public_v1",
        operation: "move",
        path: `/nodes/${encodeURIComponent(operation.ref)}/move`,
        method: "POST",
        body: {
          parent_id: operation.under,
          position: operation.position ?? "top",
        },
      };
  }
}
