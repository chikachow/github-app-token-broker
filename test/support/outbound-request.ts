export interface TestOutboundRequest {
  readonly headers: {
    get(name: string): string | null;
  };
  readonly method: string;
  readonly url: string;
}
