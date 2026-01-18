import PageSpeedComparison from "../components/pagespeed/PageSpeedInsightComparison";
import { Card, CardBody,  CardHeader } from "../components/ui";

export default function PageSpeedMobileMetrics() {
 
  return (
    <Card>
        <CardHeader className="bg-gray-900 text-white">
            <h2 className="text-2xl font-bold">PageSpeed Insights Comparison</h2>
        </CardHeader>
        <CardBody>
            <PageSpeedComparison />
        </CardBody>
    </Card>
    
  );
}
    