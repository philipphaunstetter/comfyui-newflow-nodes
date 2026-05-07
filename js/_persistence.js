import { app } from "../../scripts/app.js";

const REGISTRY = new Map();

export function installPersistence(node, opts) {
    REGISTRY.set(opts.nodeClass, opts);

    node._newflow = {
        loaded: false,
        fresh: true,
        widgetRawAtLoad: undefined,
    };

    const origConfigure = node.onConfigure;
    node.onConfigure = function (o) {
        node._newflow.fresh = false;
        node._newflow.widgetRawAtLoad = readWidgetRawAtLoad(node, o, opts);

        const ret = origConfigure?.apply(this, arguments);

        try {
            const restored = tryRestore(node, opts);
            if (restored) {
                node._newflow.loaded = true;
            } else if (!hasAnyDataSignal(node._newflow.widgetRawAtLoad)) {
                node._newflow.fresh = true;
            }
        } catch (err) {
            console.warn(`[newflow:${opts.nodeClass}] restore failed:`, err);
        }
        return ret;
    };

    const origSerialize = node.onSerialize;
    node.onSerialize = function (o) {
        const ret = origSerialize?.apply(this, arguments);
        try {
            saveGate(node, o, opts);
        } catch (err) {
            console.warn(`[newflow:${opts.nodeClass}] save-gate failed:`, err);
        }
        return ret;
    };

    return {
        markDirty: () => {},
    };
}

function readWidgetRawAtLoad(node, o, opts) {
    const wv = Array.isArray(o?.widgets_values) ? o.widgets_values : [];
    const out = {};
    for (const name of opts.widgetNames || []) {
        const idx = node.widgets?.findIndex((x) => x.name === name);
        out[name] = idx != null && idx >= 0 ? wv[idx] : undefined;
    }
    return out;
}

function hasAnyDataSignal(widgetRawAtLoad) {
    if (!widgetRawAtLoad) return false;
    for (const v of Object.values(widgetRawAtLoad)) {
        if (v != null && v !== "" && v !== "{}" && v !== "[]") return true;
    }
    return false;
}

function tryRestore(node, opts) {
    const widgetValues = (opts.widgetNames || []).map(
        (n) => node._newflow.widgetRawAtLoad?.[n],
    );
    if (!widgetValues.some((v) => v != null && v !== "" && v !== "{}" && v !== "[]")) {
        return false;
    }
    const state = opts.extractFromWidgets(widgetValues);
    if (state == null) return false;
    opts.setState(state);
    return true;
}

function saveGate(node, o, opts) {
    const canWrite = node._newflow.loaded || node._newflow.fresh;
    if (canWrite) return;

    if (!Array.isArray(o.widgets_values) || !node._newflow.widgetRawAtLoad) return;
    for (const name of opts.widgetNames || []) {
        const idx = node.widgets?.findIndex((x) => x.name === name);
        if (idx == null || idx < 0) continue;
        while (o.widgets_values.length <= idx) o.widgets_values.push(null);
        o.widgets_values[idx] = node._newflow.widgetRawAtLoad[name];
    }
}

app.registerExtension({
    name: "newflow.persistence_safety_net",
    loadedGraphNode(node) {
        if (!node?._newflow) return;
        if (node._newflow.loaded) return;
        const opts = REGISTRY.get(node.comfyClass);
        if (!opts) return;
        if (!node._newflow.widgetRawAtLoad) {
            const fakeO = {
                widgets_values: node.widgets?.map((w) => w.value) || [],
            };
            node._newflow.widgetRawAtLoad = readWidgetRawAtLoad(node, fakeO, opts);
        }
        try {
            const restored = tryRestore(node, opts);
            if (restored) node._newflow.loaded = true;
        } catch (err) {
            console.warn(
                `[newflow:${opts.nodeClass}] safety-net restore failed:`,
                err,
            );
        }
    },
});
