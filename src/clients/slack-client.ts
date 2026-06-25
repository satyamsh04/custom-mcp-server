import { WebClient } from "@slack/web-api";
import { loadConfig } from "../config.js";

let client: WebClient | undefined;

// Memoized Slack WebClient built from config.slackBotToken.
export function getSlackClient(): WebClient {
  if (client === undefined) {
    const config = loadConfig();
    client = new WebClient(config.slackBotToken);
  }
  return client;
}
