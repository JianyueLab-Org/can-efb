import { describe, expect, test } from "bun:test";
import { useLayerNotice } from "@/components/map/useLayerNotice";

/**
 * 被拒是 can-db 的事。实时那层走 can-fsd、情报区是随站发的文件，都不看 aipAccess ——
 * 拿 can-db 的拒绝去压它们的失败提示，就是把「没取到」画成「没有」：飞机停在 30 秒前
 * 的位置，而角上一个字都不说。
 */
describe("useLayerNotice", () => {
  test("被拒过之后，实时那层没取到照样说", () => {
    const n = useLayerNotice("denied");
    n.noteDenied();
    n.noteFailure("live");
    expect(n.failure.value).toBe("live");
  });

  test("实时那层的失败提示挂着时被拒，提示留着", () => {
    const n = useLayerNotice("denied");
    n.noteFailure("live");
    n.noteDenied();
    expect(n.failure.value).toBe("live");
  });

  test("被拒过之后，can-db 那几层的失败不再挂重试", () => {
    const n = useLayerNotice("denied");
    n.noteDenied();
    n.noteFailure("navaids");
    expect(n.failure.value).toBeNull();
  });

  test("can-db 那一层的失败提示挂着时被拒，提示撤掉", () => {
    const n = useLayerNotice("denied");
    n.noteFailure("airways");
    n.noteDenied();
    expect(n.failure.value).toBeNull();
  });
});
