declare module 'file-icons-js' {
  /**
   * Get icon class name of the provided filename.
   * @param name - file name
   * @returns icon class name or null if not found
   */
  export function getClass(name: string): string | null

  /**
   * Get icon class name with color of the provided filename.
   * @param name - file name
   * @returns icon class name with color or null if not found
   */
  export function getClassWithColor(name: string): string | null

  /**
   * Icon database instance
   */
  export const db: {
    matchName(name: string, directory?: boolean): any
    matchPath(path: string, directory?: boolean): any
    matchLanguage(name: string): any
    matchScope(name: string): any
    matchInterpreter(name: string): any
  }
}
