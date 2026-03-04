export const BuildLabel = () => (
    <span className="text-xs text-muted-foreground">
        v{__APP_VERSION__}.{__BUILD_NUMBER__} · {new Date(__BUILD_DATE__).toLocaleDateString()}
    </span>
)