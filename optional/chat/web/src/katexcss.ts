// katex's stylesheet, its fonts as the page's own files (woff2 alone), loaded with the
// first math; imported whole, the bundler would inline every font into the page's css

import f0 from "katex/dist/fonts/KaTeX_AMS-Regular.woff2" with { type: "file" };
import f1 from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2" with { type: "file" };
import f2 from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2" with { type: "file" };
import f3 from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2" with { type: "file" };
import f4 from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2" with { type: "file" };
import f5 from "katex/dist/fonts/KaTeX_Main-Bold.woff2" with { type: "file" };
import f6 from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2" with { type: "file" };
import f7 from "katex/dist/fonts/KaTeX_Main-Italic.woff2" with { type: "file" };
import f8 from "katex/dist/fonts/KaTeX_Main-Regular.woff2" with { type: "file" };
import f9 from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2" with { type: "file" };
import f10 from "katex/dist/fonts/KaTeX_Math-Italic.woff2" with { type: "file" };
import f11 from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2" with { type: "file" };
import f12 from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2" with { type: "file" };
import f13 from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2" with { type: "file" };
import f14 from "katex/dist/fonts/KaTeX_Script-Regular.woff2" with { type: "file" };
import f15 from "katex/dist/fonts/KaTeX_Size1-Regular.woff2" with { type: "file" };
import f16 from "katex/dist/fonts/KaTeX_Size2-Regular.woff2" with { type: "file" };
import f17 from "katex/dist/fonts/KaTeX_Size3-Regular.woff2" with { type: "file" };
import f18 from "katex/dist/fonts/KaTeX_Size4-Regular.woff2" with { type: "file" };
import f19 from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2" with { type: "file" };
import css from "katex/dist/katex.min.css" with { type: "text" };

const fonts: Record<string, string> = {
  "KaTeX_AMS-Regular": f0,
  "KaTeX_Caligraphic-Bold": f1,
  "KaTeX_Caligraphic-Regular": f2,
  "KaTeX_Fraktur-Bold": f3,
  "KaTeX_Fraktur-Regular": f4,
  "KaTeX_Main-Bold": f5,
  "KaTeX_Main-BoldItalic": f6,
  "KaTeX_Main-Italic": f7,
  "KaTeX_Main-Regular": f8,
  "KaTeX_Math-BoldItalic": f9,
  "KaTeX_Math-Italic": f10,
  "KaTeX_SansSerif-Bold": f11,
  "KaTeX_SansSerif-Italic": f12,
  "KaTeX_SansSerif-Regular": f13,
  "KaTeX_Script-Regular": f14,
  "KaTeX_Size1-Regular": f15,
  "KaTeX_Size2-Regular": f16,
  "KaTeX_Size3-Regular": f17,
  "KaTeX_Size4-Regular": f18,
  "KaTeX_Typewriter-Regular": f19,
};

// each @font-face's src the woff2 alone, at the bundled file's url
export function katexCss(): string {
  return (css as string).replace(/src:url\(fonts\/(KaTeX_[\w-]+)\.woff2\)[^;}]*/g, (all, name: string) =>
    fonts[name] ? `src:url(${fonts[name]}) format("woff2")` : all,
  );
}
