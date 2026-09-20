import { node } from "./eslint/node.js";

/** The config package lints itself, so a broken shared rule is caught where it lives. */
export default node;
