export interface CareerContextProvider {
  load(): Promise<Readonly<Record<string, unknown>>>;
}
