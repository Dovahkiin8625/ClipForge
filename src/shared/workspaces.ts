/**
 * The workspaces the application can be in.
 *
 * The editor is one of them, not the whole of it: the conversion and the
 * download are tools of their own that happen to live in the same window.
 */
export type Workspace = 'edit' | 'convert' | 'download'
