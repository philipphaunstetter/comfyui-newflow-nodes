import { app } from "../../scripts/app.js";

const NEWFLOW_PREFIX = "Newflow";

const HEADER_COLOR = "#2d1b4e";
const BODY_COLOR = "#1f1335";

const PILL_TEXT = "Newflow";
const PILL_BG = "#a78bfa";
const PILL_FG = "#1f1335";

const isNewflowNode = (nodeData) =>
    typeof nodeData?.name === "string" && nodeData.name.startsWith(NEWFLOW_PREFIX);

app.registerExtension({
    name: "newflow.brand",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isNewflowNode(nodeData)) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            this.color = HEADER_COLOR;
            this.bgcolor = BODY_COLOR;
        };

        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            origDraw?.apply(this, arguments);
            if (this.flags?.collapsed) return;

            ctx.save();
            ctx.font = "bold 10px sans-serif";
            const textW = ctx.measureText(PILL_TEXT).width;
            const padX = 7;
            const h = 16;
            const w = textW + padX * 2;
            const x = this.size[0] - w - 8;
            const titleH = LiteGraph.NODE_TITLE_HEIGHT;
            const y = -titleH + (titleH - h) / 2;
            const r = h / 2;

            ctx.fillStyle = PILL_BG;
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arcTo(x + w, y, x + w, y + r, r);
            ctx.lineTo(x + w, y + h - r);
            ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
            ctx.lineTo(x + r, y + h);
            ctx.arcTo(x, y + h, x, y + h - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = PILL_FG;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(PILL_TEXT, x + padX, y + h / 2 + 0.5);
            ctx.restore();
        };
    },
});
