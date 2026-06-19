class Result<T> {
  ok: boolean

  static Ok<T>(data: T) { return new Ok<T>(data) }
  static Err(error: Error) { return new Err(error) }

  static from<T>(value: T) {
    if (value instanceof Error)
      return Result.Err(value)
    return Result.Ok<T>(value)
  }

  static asPromise<N>(promise: Promise<N>): Promise<Result<N>>;
  static asPromise(promise: unknown) {
    return (promise as any).then(Result.Ok).catch(Result.Err)
  }

  static fromArray<N>(results: Result<N>[]): Result<N[]> {
    const result = [] as N[]
    for (let i = 0; i < results.length; i++) {
      const current = results[i]
      if (!current.ok)
        return Result.Err(current.unwrapErr())
      result.push(current.unwrap())
    }
    return Result.Ok(result)
  }

  constructor() {
    this.ok = false
  }

  isOk(): this is Ok<T> {
    return this.ok === true
  }

  isErr(): this is Err {
    return this.ok === false
  }

  unwrap() {
    if (!this.ok)
      throw new Error('Trying to unwrap from Err type')
    return (this as unknown as Ok<T>).data
  }

  unwrapOrElse<S>(value: S): T | S {
    if (!this.ok)
      return value
    return (this as unknown as Ok<T>).data
  }

  unwrapErr() {
    if (this.ok)
      throw new Error('Trying to unwrap error from Ok type')
    return (this as unknown as Err).error
  }

  map<S>(fn: (m: T) => S): Result<S> {
    if (!this.ok)
      return (this as unknown as Result<S>)
    return Result.Ok(fn((this as unknown as Ok<T>).data))
  }
}

class Ok<T> extends Result<T> {
  ok: true
  data: T
  constructor(data: T) {
    super()
    this.ok = true
    this.data = data
  }
}

class Err extends Result<any> {
  ok: false
  error: Error
  constructor(error: Error) {
    super()
    this.ok = false
    this.error = error
  }
}

export default Result
