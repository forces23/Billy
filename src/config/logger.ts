import pino from "pino";

import { env } from "./env.js";

export default pino({
  level: env.logLevel,
});
