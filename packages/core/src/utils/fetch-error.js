//  =====================================================================
//  Why a fetch failed
//  =====================================================================
//  Deno's fetch rejects with only "fetch failed" and puts the reason
//  in `cause`, as a chain such as "error sending request for url
//  (...): client error (Connect): tcp connect error: Connection
//  refused (os error 61)". The last link is the part a person needs.

const LINK_SEPARATOR = ": ";

/**
 * @param {unknown} err - What fetch rejected with.
 * @returns {string} "Connection refused (os error 61)", or the error's
 *     own message when it has no cause.
 */
export function describeFetchError(err) {
    const detail = err?.cause?.message;

    if (typeof detail !== "string") {
        return err?.message ?? String(err);
    }

    const lastLink = detail.lastIndexOf(LINK_SEPARATOR);

    if (lastLink === -1) {
        return detail;
    }

    return detail.slice(lastLink + LINK_SEPARATOR.length);
}
