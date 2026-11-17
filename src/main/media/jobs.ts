/**
 * A small queue for the FFmpeg jobs of the media system.
 *
 * Importing a handful of large movies used to start a dozen FFmpeg processes
 * at once, and they then fought over the same disks and cores — every one of
 * them got slower, and the machine became unusable while it happened. A few
 * at a time is quicker overall, and the first result arrives sooner.
 */

const MAX_PARALLEL = 3

let running = 0
const waiting: (() => void)[] = []

function drain(): void {
  const next = waiting.shift()
  if (next) next()
}

/** Runs a job as soon as there is room for it. */
export function withJob<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      running++
      job().then(
        (value) => {
          running--
          resolve(value)
          drain()
        },
        (err) => {
          running--
          reject(err)
          drain()
        }
      )
    }

    if (running < MAX_PARALLEL) run()
    else waiting.push(run)
  })
}
