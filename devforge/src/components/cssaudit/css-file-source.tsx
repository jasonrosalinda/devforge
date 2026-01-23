import { View } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";


export default function CSSFileSource({ name, source }: { name: string, source: string }) {
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="ghost" title={name} size="icon"><View /></Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{name}</DialogTitle>
                </DialogHeader>
                <div className="no-scrollbar -mx-4 max-h-[50vh] overflow-y-auto px-4">
                    <code>
                        {source}
                    </code>
                </div>
            </DialogContent>
        </Dialog>
    )
}