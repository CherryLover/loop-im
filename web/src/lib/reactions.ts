/**
 * 可选的表情回应。故意只给一小组常用的：不引表情选择器依赖，也就没有几百 KB 的
 * 表情数据和一整套搜索交互要维护。
 *
 * 这份列表必须与服务端 server/src/reactions.js 的 REACTION_EMOJIS 一致——那边是白名单，
 * 不在名单里的一律 400。两边要一起改。
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😄', '🎉', '😮', '🙏'];
