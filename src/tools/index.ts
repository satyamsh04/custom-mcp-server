import type { ToolModule } from "../types.js";
import s3Upload from "./s3-upload.js";
import s3Download from "./s3-download.js";
import dynamoRead from "./dynamo-read.js";
import dynamoWrite from "./dynamo-write.js";
import slackNotify from "./slack-notify.js";
import annotationStatus from "./annotation-status.js";

const modules: ToolModule[] = [
  s3Upload as ToolModule,
  s3Download as ToolModule,
  dynamoRead as ToolModule,
  dynamoWrite as ToolModule,
  slackNotify as ToolModule,
  annotationStatus as ToolModule,
];

// Map of tool name -> ToolModule, keyed by each module's definition.name.
export const tools: Record<string, ToolModule> = Object.fromEntries(
  modules.map((m) => [m.definition.name, m]),
);
