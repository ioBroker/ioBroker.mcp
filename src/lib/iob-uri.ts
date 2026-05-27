/**
 * Canonical ioBroker URI helpers, ported from `@iobroker/adapter-react-v5` (`Components/IobUri`).
 *
 *   - state:  `iobstate://<id>[/<attr>]`            (attr: val, ts, lc, ack, q, from, ...)
 *   - object: `iobobject://<id>[/<attr.path>]`      (attr.path: common.enabled, native.x, ...)
 *   - file:   `iobfile://<adapter>/<dir>/<file>`
 *   - http:   `http(s)://...`
 *   - base64: `data:...`
 */
export type IobUriType = 'object' | 'state' | 'file' | 'http' | 'base64';

export interface IobUriParsed {
    type: IobUriType;
    address: string;
    path?: string;
}

export function iobUriToString(uri: IobUriParsed): string {
    if (uri.type === 'object') {
        return `iobobject://${uri.address}/${uri.path || ''}`;
    }
    if (uri.type === 'state') {
        return `iobstate://${uri.address}`;
    }
    if (uri.type === 'file') {
        return `iobfile://${uri.address}/${uri.path || ''}`;
    }
    if (uri.type === 'http') {
        return uri.address;
    }
    if (uri.path?.includes('/')) {
        return `iobfile://${uri.address}/${uri.path}`;
    }
    if (uri.path) {
        return `iobobject://${uri.address}/${uri.path}`;
    }
    return `iobstate://${uri.address}`;
}

/** Parse an ioBroker URI. */
export function iobUriParse(uri: string): IobUriParsed {
    const result: IobUriParsed = { type: 'object', address: '' };
    if (uri.startsWith('iobobject://')) {
        result.type = 'object';
        const parts = uri.replace('iobobject://', '').split('/');
        result.address = parts[0];
        result.path = parts[1]; // native.schemas.myObject
    } else if (uri.startsWith('iobstate://')) {
        result.type = 'state';
        const parts = uri.replace('iobstate://', '').split('/');
        result.address = parts[0];
        result.path = parts[1]; // val, ts, lc, from, q, ...
    } else if (uri.startsWith('iobfile://')) {
        result.type = 'file';
        const parts = uri.replace('iobfile://', '').split('/');
        result.address = parts.shift() || '';
        result.path = parts.join('/'); // main/img/hello.png
    } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
        result.type = 'http';
        result.address = uri;
    } else if (uri.startsWith('data:')) {
        result.type = 'base64';
        result.address = uri;
    } else {
        // no protocol provided
        const parts = uri.split('/');
        if (parts.length === 2) {
            result.address = parts[0];
            result.path = parts[1];
            if (result.path.includes('.')) {
                result.type = 'object';
            } else if (result.path) {
                if (
                    ['val', 'q', 'ack', 'ts', 'lc', 'from', 'user', 'expire', 'c'].includes(result.path)
                ) {
                    result.type = 'state';
                } else if (['common', 'native', 'from', 'acl', 'type'].includes(result.path)) {
                    result.type = 'object';
                } else {
                    throw new Error(`Unknown path: ${result.path}`);
                }
            } else {
                result.type = 'state';
            }
        } else if (parts.length === 1) {
            result.address = parts[0];
            result.type = 'state';
        } else {
            result.address = parts.shift() || '';
            result.type = 'file';
            result.path = parts.join('/');
        }
    }
    return result;
}

/** Read a nested attribute from an object by a dotted path (e.g. ["common","enabled"]). */
export function getAttrInObject(obj: Record<string, any> | null | undefined, path: string[] | undefined): any {
    if (obj === undefined || obj === null || !path || !path.length) {
        return obj;
    }
    let current: any = obj;
    for (const key of path) {
        if (current && typeof current === 'object') {
            current = current[key];
        } else {
            return undefined;
        }
    }
    return current;
}
