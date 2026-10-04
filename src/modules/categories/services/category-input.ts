import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CategoryInputRef } from './category-resolution.service';

/**
 * Fold a product write's two category fields into one list of refs.
 *
 *  - `categories` (the current field) wins and is returned as-is.
 *  - `category` (DEPRECATED single string) becomes `[{ name }]`.
 *  - Neither → `undefined`, which on an update means "leave the categories alone".
 *  - Both → refused: the two could disagree, and guessing which one the client meant
 *    is how a product silently ends up on the wrong shelf.
 */
export function categoryRefsFromBody(body: {
    categories?: CategoryInputRef[];
    category?: string;
}): CategoryInputRef[] | undefined {
    if (body.categories !== undefined && body.category !== undefined) {
        throw createAppError(
            ERROR_CODES.CATEGORY_NAME_INVALID,
            400,
            'Send `categories` or the deprecated `category`, not both',
        );
    }
    if (body.categories !== undefined) return body.categories;
    if (body.category !== undefined) return [{ name: body.category }];
    return undefined;
}
