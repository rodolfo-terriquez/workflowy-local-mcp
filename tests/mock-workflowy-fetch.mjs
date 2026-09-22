let mirrorExists = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";

  if (url.pathname === "/api/v1/targets" && method === "GET") {
    return json({ targets: [] });
  }

  if (url.pathname === "/api/v1/nodes/origin-1/mirror" && method === "POST") {
    mirrorExists = true;
    return json({ item_id: "mirror-1", origin_id: "origin-1" });
  }

  if (url.pathname === "/api/v1/nodes/mirror-1/mirror" && method === "DELETE") {
    mirrorExists = false;
    return json({ status: "ok" });
  }

  if (url.pathname === "/api/v1/nodes/mirror-1" && method === "GET") {
    if (!mirrorExists) return json({ error: "not found" }, 404);
    return json({
      node: {
        id: "mirror-1",
        name: "Shared mirror item",
        note: null,
        parent_id: "parent-1",
        priority: 0,
        createdAt: 1,
        modifiedAt: 2,
        completedAt: null,
        data: { mirror: { origin_id: null } },
      },
    });
  }

  if (url.pathname === "/api/v1/nodes" && method === "GET") {
    const parentId = url.searchParams.get("parent_id");
    if (parentId === "parent-1") {
      return json({
        nodes: mirrorExists
          ? [{
              id: "mirror-1",
              name: "Shared mirror item",
              note: null,
              priority: 0,
              createdAt: 1,
              modifiedAt: 2,
              completedAt: null,
            }]
          : [],
      });
    }
    if (parentId === "mirror-1") {
      return json({ nodes: [], mirror: { origin_id: null } });
    }
    return json({ nodes: [] });
  }

  if (url.pathname === "/api/v1/nodes-export" && method === "GET") {
    return json({ nodes: [] });
  }

  return json({ error: `Unhandled synthetic request: ${method} ${url.pathname}${url.search}` }, 500);
};
