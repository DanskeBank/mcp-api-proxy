import { createRequire } from "node:module";
import { z } from "zod";

export const PACKAGE_VERSION = z
  .object({ version: z.string().min(1) })
  .parse(createRequire(import.meta.url)("../package.json")).version;
