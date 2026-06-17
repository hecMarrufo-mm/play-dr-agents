import { z, ZodError } from 'zod';
import { badRequest } from './errors';

/**
 * Parse `data` against a Zod schema, throwing a 400 AppError on failure.
 * Returns the schema's OUTPUT type (so `.default()` fields are non-optional).
 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest(
        'Validation failed',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }
}
