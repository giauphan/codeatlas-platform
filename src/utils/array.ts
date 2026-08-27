/**
 * Utility functions for optimized array operations.
 */

/**
 * Counts the number of elements in an array that match a given condition.
 * This is an optimized alternative to `arr.filter(condition).length` which avoids
 * allocating an intermediate array and reduces garbage collection pressure.
 *
 * @param arr The array to iterate over.
 * @param condition A function that returns true if the element should be counted.
 * @returns The number of elements that match the condition.
 */
export function countMatching<T>(arr: T[], condition: (elem: T) => boolean): number {
  let count = 0;
  const len = arr.length;
  for (let i = 0; i < len; i++) {
    if (condition(arr[i])) {
      count++;
    }
  }
  return count;
}
