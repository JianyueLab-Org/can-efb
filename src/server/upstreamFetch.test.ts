import { afterAll, describe, expect, test } from "bun:test";
import { copySetCookies, fetchHeadersWithin } from "./upstreamFetch";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/slow-headers") {
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response("late")), 300),
      );
    }
    // 头立刻到，body 在超时之后才写完。
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("part1-"));
        await new Promise((r) => setTimeout(r, 200));
        controller.enqueue(new TextEncoder().encode("part2"));
        controller.close();
      },
    });
    return new Response(stream);
  },
});

afterAll(() => server.stop(true));

describe("fetchHeadersWithin", () => {
  test("头迟迟不来就中止", async () => {
    await expect(
      fetchHeadersWithin(`${server.url}slow-headers`, {}, 50),
    ).rejects.toThrow();
  });

  test("头到了之后，body 慢也不会被截断", async () => {
    const response = await fetchHeadersWithin(`${server.url}slow-body`, {}, 50);
    expect(await response.text()).toBe("part1-part2");
  });
});

describe("copySetCookies", () => {
  test("多条 Set-Cookie 逐条保留，不被逗号拼成一条", () => {
    const from = new Headers();
    from.append("set-cookie", "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    from.append("set-cookie", "b=2; Path=/");
    const out = new Headers();
    copySetCookies(from, out);
    expect(out.getSetCookie()).toEqual([
      "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "b=2; Path=/",
    ]);
  });
});
