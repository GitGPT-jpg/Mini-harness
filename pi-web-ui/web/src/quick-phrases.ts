/**
 * 快捷短语内置默认值（按界面语言，与 i18n Locale 对齐；ja/ko/fr/de/es/ru/pt 为机器翻译占位）。
 *
 * 服务端对新客户端只给空列表（不知道浏览器语言），由 App 在首次看到空列表时
 * 按当前 locale seed 一次（见 App 的 seeding effect + isQuickSeeded，按浏览器
 * 全局只 seed 一次）；seed 后即为普通用户数据，可在设置里增删改、恢复默认、关闭。
 * 约束与服务端归一化对齐：
 * 单条 ≤200 字、最多 30 条、无空项无重名。
 */
import type { Locale } from "./i18n";

export const QUICK_PHRASE_DEFAULTS: Record<Locale, string[]> = {
	zh: ["继续", "总结一下", "详细解释一下", "检查并修复问题", "补充测试覆盖", "发布上传"],
	en: ["Continue", "Summarize", "Explain in detail", "Check and fix issues", "Add test coverage", "Publish release"],
	it: [
		"Continua",
		"Riassumi",
		"Spiega in dettaglio",
		"Verifica e correggi i problemi",
		"Aggiungi copertura dei test",
		"Pubblica la release",
	],
	ja: ["続ける", "要約して", "詳しく説明して", "問題を確認して修正", "テストカバレッジを追加", "公開・リリース"],
	ko: ["계속", "요약해줘", "자세히 설명해줘", "문제를 확인하고 수정", "테스트 커버리지 추가", "게시/릴리스"],
	fr: [
		"Continuer",
		"Résumer",
		"Expliquer en détail",
		"Vérifier et corriger les problèmes",
		"Ajouter des tests",
		"Publier",
	],
	de: [
		"Weiter",
		"Zusammenfassen",
		"Ausführlich erklären",
		"Probleme prüfen und beheben",
		"Testabdeckung ergänzen",
		"Veröffentlichen",
	],
	es: [
		"Continuar",
		"Resumir",
		"Explicar en detalle",
		"Revisar y corregir problemas",
		"Añadir cobertura de pruebas",
		"Publicar",
	],
	ru: [
		"Продолжить",
		"Подведи итог",
		"Объясни подробно",
		"Проверь и исправь проблемы",
		"Добавь покрытие тестами",
		"Опубликовать",
	],
	pt: [
		"Continuar",
		"Resumir",
		"Explique em detalhes",
		"Verifique e corrija os problemas",
		"Adicione cobertura de testes",
		"Publique a release",
	],
};
