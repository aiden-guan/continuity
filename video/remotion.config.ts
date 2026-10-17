// CLI-only settings (`remotion studio` / `remotion render`). The Node.js APIs ignore this file.
// Reference: https://remotion.dev/docs/config
import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);

// Remotion's bundled chrome-headless-shell fails to load its ICU data here, so prefer a local Chrome install.
const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (existsSync(chromeApp)) {
  Config.setBrowserExecutable(chromeApp);
}
