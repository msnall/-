import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  // The review desk page is an ordinary web app around the Remotion Player,
  // not a composition: plain <img> is right there.
  { files: ["desk/ui/**"], rules: { "@remotion/warn-native-media-tag": "off" } },
];
