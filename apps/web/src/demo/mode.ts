/** 显式开发入口；生产构建常量为 false，不可作为 API 失败降级。 */
export const isDemo = import.meta.env.DEV && window.location.pathname.startsWith('/demo/');
