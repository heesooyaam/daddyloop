export const clipTitle = (text: string, limit = 128) =>
  text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
export function titleFromGoal(goal: string) {
  return clipTitle(
    goal
      .trim()
      .split('\n')
      .find((line) => line.trim())
      ?.replace(/\s+/g, ' ')
      .trim() ?? '',
    100,
  );
}
