// Screenshot cleanup before Tesseract sees it.
const {
  contrastStops, histogram, luminance, meanLuminance,
  normalisePixels, ocrScale, shouldInvert,
} = await import("./.ocr.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

/** An RGBA buffer of the given grey values. */
const pixels = (values) => {
  const buf = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => {
    buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 255;
  });
  return buf;
};

section("brightness");
check("white is 255", Math.round(luminance(255, 255, 255)), 255);
check("black is 0", Math.round(luminance(0, 0, 0)), 0);
// Green dominates perceived brightness, which is why a flat average is wrong.
check("green reads brighter than blue", luminance(0, 255, 0) > luminance(0, 0, 255), true);

section("dark mode detection");
// A phone screenshot is mostly background, so the average is the background.
const darkShot = pixels([...Array(90).fill(26), ...Array(10).fill(210)]);
const lightShot = pixels([...Array(90).fill(245), ...Array(10).fill(30)]);
check("light text on dark is inverted", shouldInvert(histogram(darkShot)), true);
check("dark text on light is left alone", shouldInvert(histogram(lightShot)), false);
check("the average is the background", Math.round(meanLuminance(histogram(darkShot))), 44);

section("contrast stretching");
// A washed-out screenshot spanning only 90-200 should be pulled to full range.
const flat = pixels(Array.from({ length: 200 }, (_, i) => 90 + (i % 111)));
const stops = contrastStops(histogram(flat));
check("the low end is found", stops.low >= 90 && stops.low <= 95, true);
check("the high end is found", stops.high >= 195 && stops.high <= 200, true);

// One stray white icon must not define the top of the range: the text spans
// 60-180, so the stretch should target 180 and let the icon clip.
const withOutlier = pixels([...Array.from({ length: 200 }, (_, i) => 60 + (i % 121)), 255]);
check("a lone bright pixel does not set the top", contrastStops(histogram(withOutlier)).high, 180);

// A blank image has no range to stretch; stretching it would amplify noise.
check("a flat image is left alone", contrastStops(histogram(pixels(Array(50).fill(128)))), { low: 0, high: 255 });
check("an empty image is safe", contrastStops(new Uint32Array(256)), { low: 0, high: 255 });

section("normalising");
const dark = pixels([26, 26, 210, 210]);
normalisePixels(dark, { low: 26, high: 210 }, true);
check("dark background becomes white", dark[0], 255);
check("light text becomes black", dark[8], 0);
check("alpha is untouched", dark[3], 255);

const light = pixels([245, 30]);
normalisePixels(light, { low: 30, high: 245 }, false);
check("a light screenshot keeps its polarity", [light[0], light[4]], [255, 0]);

// Values outside the chosen stops must clamp, not wrap around.
const extreme = pixels([0, 255]);
normalisePixels(extreme, { low: 50, high: 200 }, false);
check("below the low stop clamps to black", extreme[0], 0);
check("above the high stop clamps to white", extreme[4], 255);

section("scaling for recognition");
// Tesseract wants roughly 300 DPI; a phone screenshot is well under that.
check("a small screenshot is enlarged", ocrScale(1200, 800) > 1, true);
check("1600px goes to the 2400 target", Number(ocrScale(1600, 900).toFixed(2)), 1.5);
// Detail lost by shrinking cannot be recovered by the recogniser.
check("a large screenshot is never shrunk", ocrScale(4000, 3000), 1);
check("upscaling is capped", ocrScale(100, 100), 2);
check("a zero-size image is safe", ocrScale(0, 0), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
