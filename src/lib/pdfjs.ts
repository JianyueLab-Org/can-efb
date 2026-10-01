/**
 * pdf.js 按需加载：第一次打开航图时才取，之后复用同一份。
 *
 * worker 用 `?url` 交给 Vite 当静态资源打包，和页面同源，不走任何 CDN。加载失败
 * 不记住失败 —— 下一次打开会重试。
 *
 * NAIP 航图的中文字体都是嵌入的 Identity-H，所以没配 `cMapUrl`。没嵌入的只有
 * Times New Roman 一类标准字体，浏览器用系统字体替代。
 */
type PdfJs = typeof import("pdfjs-dist");

export type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
export type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
export type PdfRenderTask = ReturnType<PdfPage["render"]>;

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!loading) {
    loading = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
