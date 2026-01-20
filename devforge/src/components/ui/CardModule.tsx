export function CardModule({ header, body }: { header: React.ReactNode, body: React.ReactNode }) {
    return (
        <div className="bg-white rounded-lg shadow overflow-hidden">
            {/* Header Area */}
            {header && (
                <div className="bg-gray-900 shadow p-3">
                    <div className="flex items-center gap-4 flex-wrap justify-between text-white">
                        {header}
                    </div>
                </div>
            )}

            {/* Content Area */}
            <div className="overflow-auto">
                {body}
            </div>
        </div>
    );
}