/**
 * The height of the phone app bar, shared by the shell that draws it and the
 * `PageHeader` that parks beneath it.
 *
 * One constant because two sticky elements both claiming `top: 0` is the bug this
 * replaces: the page heading slid under the app bar and the subject you were
 * reading vanished on the first scroll. Any disagreement between the two numbers
 * shows up as a strip of canvas sliding between them, so they read the same one.
 */
export const MOBILE_BAR_HEIGHT = "3.25rem";

/** Where a page's sticky heading sits: under the bar, below the notch. */
export const MOBILE_BAR_OFFSET = `calc(${MOBILE_BAR_HEIGHT} + env(safe-area-inset-top))`;
