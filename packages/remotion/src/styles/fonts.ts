import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";

const { fontFamily: interFontFamily } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const { fontFamily: headingFontFamily } = loadOswald("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export { interFontFamily, headingFontFamily };
