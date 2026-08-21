export interface NodeCliInvocation {
  readonly file: string
  readonly args: readonly string[]
}

export declare function nodeCliInvocation(
  nodeExecutable: string,
  entry: string,
  args: readonly string[],
): NodeCliInvocation

export declare function packageManagerEntry(value: string | undefined): string
