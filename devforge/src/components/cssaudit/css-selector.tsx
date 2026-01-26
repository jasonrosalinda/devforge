import { Eye } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";


export default function CssSelector({ name, selectors }: { name: string, selectors: string[] }) {
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="ghost" title={name} size="icon"><Eye /></Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{name}</DialogTitle>
                </DialogHeader>
                <div className="no-scrollbar -mx-4 max-h-[50vh] overflow-y-auto px-4 gap-5 flex flex-col">
                    {selectors.map((selector, index) => (
                        <div key={index} className="flex gap-2">
                            <div className="text-muted-foreground text-sm">{index + 1}</div>
                            <code className="flex block text-sm" >
                                {selector}
                            </code>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}