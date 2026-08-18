declare module "jsdom" {
  export class JSDOM {
    constructor(input?: string, options?: { contentType?: string });
    readonly window: { document: Document };
  }
}
