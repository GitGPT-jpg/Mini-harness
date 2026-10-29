/** Vite 8 的 client 类型不再声明 `*.css`（Vite 6/7 有），裸 CSS 副作用导入靠这一行兜住。 */
declare module "*.css";
