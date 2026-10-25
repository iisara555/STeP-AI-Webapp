// Packages the engine imports but the server never installs: UI-only, or providers that stay off (ADR 0001, item 5).
declare module '@github/copilot-sdk' {
  export class CopilotClient {
    constructor(...args: any[]);
    [member: string]: any;
  }
}
declare module '@anthropic-ai/claude-agent-sdk' {
  export type Query = any;
  export type SDKUserMessage = any;
  export type EffortLevel = any;
  export type SpareProcess = any;
  export const query: (...args: any[]) => any;
}
declare module 'react-markdown' {
  export type Components = any;
  const Markdown: any;
  export default Markdown;
}
declare module 'remark-gfm' {
  const plugin: any;
  export default plugin;
}
declare module 'highlight.js/lib/*' {
  const language: any;
  export default language;
}
