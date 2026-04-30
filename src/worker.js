export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/run" && request.method === "POST") {
      const { task = "" } = await request.json().catch(() => ({}));
      return Response.json({
        version: "0.0.1",
        task,
        childCount: 1,
        prompt: `You are a Terrarium child agent. Complete one task and return concise results.\n\nTask:\n${task}`,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
