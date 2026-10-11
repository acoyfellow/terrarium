export const piChildArgs = (baseArgs: ReadonlyArray<string>, promptPath: string): ReadonlyArray<string> => [...baseArgs, `@${promptPath}`];
