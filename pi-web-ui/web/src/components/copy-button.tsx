import { memo } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { useT } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";

export const CopyButton = memo(function CopyButton({ text }: { text: string }) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	if (!text) return null;
	return (
		<button type="button" className="copy-btn" title={t("copy")} onClick={() => void copy(text)}>
			{copied ? <FiCheck /> : <FiCopy />}
		</button>
	);
});
