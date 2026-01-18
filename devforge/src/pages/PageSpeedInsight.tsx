import PageSpeedComparison from "../components/pagespeed/PageSpeedInsightComparison";
import PageSpeedInsightResult from "../components/pagespeed/PageSpeedInsightResult";
import { Card, CardBody, CardHeader } from "../components/ui";

export default function PageSpeedMobileMetrics() {
  return (
    <div className="space-y-12">
      <Card>
        <CardHeader className="bg-gray-900 text-white">
          <h2 className="text-2xl font-bold">PageSpeed Insights</h2>
        </CardHeader>
        <CardBody>
          <PageSpeedInsightResult />
        </CardBody>
      </Card>
      <div className="border-b border-black/10 pb-12">
        <Card>
          <CardHeader className="bg-gray-900 text-white">
            <h2 className="text-2xl font-bold">
              PageSpeed Insights Comparison
            </h2>
          </CardHeader>
          <CardBody>
            <PageSpeedComparison />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
