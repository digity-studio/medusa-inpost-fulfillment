import { Logger } from "@medusajs/framework/types";
import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils";
import {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/types";
import { canCancelInPostShipmentViaApi } from "../../lib/admin-shipments";
import { InPostShipXClient } from "../../lib/client";
import { assertNoExistingShipment } from "../../lib/duplicate-shipments";
import {
  buildShipmentRequest,
  buildTrackingUrl,
  InPostFulfillmentData,
  resolveLabelFormat,
} from "../../lib/fulfillment";
import {
  InPostOfferPolling,
  resolveOfferPolling,
  waitForOffers,
} from "../../lib/timeouts";
import {
  InPostPluginOptions,
  InPostService,
} from "../../lib/types";

type InjectedDependencies = {
  logger: Logger;
};

function toInPostFulfillmentData(
  data: Record<string, unknown>
): InPostFulfillmentData {
  return {
    service_type: data.service_type as InPostFulfillmentData["service_type"],
    target_point: data.target_point as string | undefined,
    parcel_template:
      data.parcel_template as InPostFulfillmentData["parcel_template"],
    label_format: data.label_format as InPostFulfillmentData["label_format"],
    parcel_dimensions:
      data.parcel_dimensions as InPostFulfillmentData["parcel_dimensions"],
    email: data.email as string | undefined,
  };
}

class InPostFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "inpost";

  private client: InPostShipXClient;
  private logger: Logger;
  private options: InPostPluginOptions;
  private offerPolling: InPostOfferPolling;

  constructor(dependencies: InjectedDependencies, options: InPostPluginOptions) {
    super();

    if (!options.apiToken) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "InPost fulfillment provider: missing required option `apiToken`"
      );
    }
    if (!options.organizationId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "InPost fulfillment provider: missing required option `organizationId`"
      );
    }

    this.logger = dependencies.logger;
    this.options = options;
    this.client = new InPostShipXClient(options);
    this.offerPolling = resolveOfferPolling(options);
  }

  async getFulfillmentOptions() {
    return [
      {
        id: InPostService.inpost_locker_standard,
        name: "InPost Paczkomat (locker delivery)",
        is_return: false,
      },
      {
        id: InPostService.inpost_courier_standard,
        name: "InPost Courier (home delivery)",
        is_return: false,
      },
    ];
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return Object.values(InPostService).includes(data.id as InPostService);
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    const fulfillmentData = toInPostFulfillmentData(data);
    const serviceId = optionData.id as InPostService;

    const isLockerService = serviceId === InPostService.inpost_locker_standard;

    if (isLockerService && !fulfillmentData.target_point) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "InPost locker delivery requires `target_point` (Paczkomat machine ID) in fulfillment data"
      );
    }

    resolveLabelFormat(this.options, fulfillmentData);

    // Extract parcel dimensions from cart items' variant data.
    // For courier shipments, we aggregate item dimensions to build
    // the parcel size sent to InPost.
    type CartItem = {
      quantity: number;
      variant?: {
        weight?: number;
        length?: number;
        height?: number;
        width?: number;
      };
    };
    const items = (context as ValidateFulfillmentDataContext & {
      items?: CartItem[];
    }).items;

    let parcelDimensions:
      | { length: number; width: number; height: number; weight: number }
      | undefined;

    if (items?.length) {
      let totalWeight = 0;
      let maxLength = 0;
      let maxWidth = 0;
      let totalHeight = 0;

      for (const item of items) {
        const qty = item.quantity || 1;
        const v = item.variant;
        if (v) {
          totalWeight += (v.weight || 0) * qty;
          maxLength = Math.max(maxLength, v.length || 0);
          maxWidth = Math.max(maxWidth, v.width || 0);
          totalHeight += (v.height || 0) * qty;
        }
      }

      if (totalWeight > 0 || maxLength > 0 || maxWidth > 0 || totalHeight > 0) {
        parcelDimensions = {
          length: maxLength,
          width: maxWidth,
          height: totalHeight,
          weight: totalWeight,
        };
      }
    }

    return {
      ...data,
      service_type: serviceId,
      target_point: fulfillmentData.target_point,
      label_format: resolveLabelFormat(this.options, fulfillmentData),
      ...(parcelDimensions && { parcel_dimensions: parcelDimensions }),
    };
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false;
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    _context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    return { calculated_amount: 0, is_calculated_price_tax_inclusive: true };
  }

  async createFulfillment(
    data: Record<string, unknown>,
    _items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    const fulfillmentData = toInPostFulfillmentData(data);
    const shippingAddress = order?.shipping_address;

    if (!shippingAddress) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "InPost fulfillment: shipping address is required"
      );
    }

    const email =
      order?.email ||
      (order as Partial<FulfillmentOrderDTO> & { customer?: { email?: string } })?.customer?.email ||
      fulfillmentData.email ||
      "";

    const serviceType = fulfillmentData.service_type;

    const isLockerService =
      serviceType === InPostService.inpost_locker_standard;
    const labelFormat = resolveLabelFormat(this.options, fulfillmentData);
    const reference = order?.id || fulfillment.id;
    const shipmentRequest = buildShipmentRequest({
      data: fulfillmentData,
      options: this.options,
      shippingAddress,
      email,
      reference,
    });

    // Known once ShipX has created the shipment, so a failure after that point
    // (offers, buy, dispatch order) says which shipment it left behind.
    let shipmentId: number | undefined;

    try {
      if (this.options.duplicateCheck !== false && reference) {
        await assertNoExistingShipment(
          (query) => this.client.listShipments(query),
          { reference, email, createdAt: order?.created_at }
        );
      }

      const shipment = await this.client.createShipment(shipmentRequest);
      shipmentId = shipment.id;

      // Poll until shipment is confirmed or offers are ready
      let current = await waitForOffers(
        shipment,
        (id) => this.client.getShipment(id),
        this.offerPolling
      );

      // If not yet confirmed, try the offer flow (select + buy)
      if (current.status !== "confirmed") {
        const offer = current.offers?.find((o) => o.status === "available") ||
          current.selected_offer ||
          current.offers?.[0];

        if (!offer) {
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            `InPost fulfillment: shipment ${shipment.id} stuck in status "${current.status}" with no available offers`
          );
        }

        current = await this.client.buyShipment(shipment.id, offer.id);
      }

      let dispatchOrderId: number | undefined;

      if (!isLockerService) {
        const senderAddress = shipmentRequest.sender?.address;

        if (!senderAddress) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "InPost fulfillment: `sender.address` is required in plugin options for courier shipments (needed to create a dispatch order)"
          );
        }

        const dispatchOrder = await this.client.createDispatchOrder(
          [current.id],
          {
            street: senderAddress.street,
            building_number: senderAddress.building_number,
            city: senderAddress.city,
            post_code: senderAddress.post_code,
            country_code: senderAddress.country_code,
          }
        );

        dispatchOrderId = dispatchOrder.id;
      }

      return {
        data: {
          shipment_id: current.id,
          tracking_number: current.tracking_number,
          tracking_url: buildTrackingUrl(current.tracking_number),
          status: current.status,
          service_type: serviceType,
          target_point: fulfillmentData.target_point,
          label_format: labelFormat,
          ...(dispatchOrderId && { dispatch_order_id: dispatchOrderId }),
        },
        labels: current.tracking_number
          ? [
              {
                tracking_number: current.tracking_number,
                tracking_url: buildTrackingUrl(current.tracking_number),
                label_url: "",
              },
            ]
          : [],
      };
    } catch (error) {
      this.logger.error(
        shipmentId
          ? `InPost createFulfillment failed after creating shipment ${shipmentId} on ShipX`
          : "InPost createFulfillment failed",
        error as Error
      );
      throw error;
    }
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const shipmentId = data.shipment_id as number | undefined;

    if (!shipmentId) {
      this.logger.error(
        "InPost cancelFulfillment: no shipment_id in data, skipping cancellation"
      );
      return {};
    }

    try {
      // ShipX only allows API cancellation before confirmation. Once a shipment
      // is confirmed, the physical shipment must be cancelled manually in InPost.

      let status: string | undefined;
      try {
        const shipment = await this.client.getShipment(shipmentId);
        status = shipment.status;
      } catch (error) {
        this.logger.warn(
          `InPost cancelFulfillment: could not fetch shipment ${shipmentId} status, attempting cancel anyway: ${(error as Error).message}`
        );
      }

      if (status && !canCancelInPostShipmentViaApi(status)) {
        this.logger.warn(
          `InPost cancelFulfillment: shipment ${shipmentId} is in status "${status}" and cannot be cancelled via API. Marking fulfillment cancelled locally — cancel the shipment manually in InPost Manager if needed.`
        );
        return {};
      }

      await this.client.cancelShipment(shipmentId);
    } catch (error) {
      this.logger.error("InPost cancelFulfillment failed", error as Error);
      throw error;
    }

    return {};
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    // Medusa's default return flow doesn't provide enough data to create
    // an InPost return shipment (no target_point for locker, no order address).
    // Return shipments should be created manually in InPost Manager.
    this.logger.info(
      "InPost createReturnFulfillment - skipping InPost API call, return shipment should be created manually in InPost Manager"
    );

    return {
      data: {
        note: "Return shipment not created automatically. Please create it manually in InPost Manager.",
      },
      labels: [],
    };
  }

  // Note: base class declares Promise<never[]> which appears incorrect; we
  // return real document objects, so we use `any` here to satisfy the override.
  async getFulfillmentDocuments(data: Record<string, unknown>): Promise<any> {
    const shipmentId = data.shipment_id as number | undefined;

    if (!shipmentId) {
      return [];
    }

    try {
      const labelFormat = resolveLabelFormat(
        this.options,
        toInPostFulfillmentData(data)
      );
      const labelBuffer = await this.client.getLabel(shipmentId, labelFormat);
      return [
        {
          base64: labelBuffer.toString("base64"),
          name: `inpost-label-${shipmentId}.${labelFormat}`,
          type:
            labelFormat === "pdf"
              ? "application/pdf"
              : "application/octet-stream",
        },
      ];
    } catch (error) {
      this.logger.error(
        "InPost getFulfillmentDocuments failed",
        error as Error
      );
      throw error;
    }
  }

  async getReturnDocuments(data: Record<string, unknown>): Promise<any> {
    const shipmentId =
      (data.return_shipment_id as number | undefined) ||
      (data.shipment_id as number | undefined);

    if (!shipmentId) {
      return [];
    }

    try {
      const labelFormat = resolveLabelFormat(
        this.options,
        toInPostFulfillmentData(data)
      );
      const labelBuffer = await this.client.getLabel(shipmentId, labelFormat);
      return [
        {
          base64: labelBuffer.toString("base64"),
          name: `inpost-return-label-${shipmentId}.${labelFormat}`,
          type:
            labelFormat === "pdf"
              ? "application/pdf"
              : "application/octet-stream",
        },
      ];
    } catch (error) {
      this.logger.error("InPost getReturnDocuments failed", error as Error);
      throw error;
    }
  }

  async getShipmentDocuments(data: Record<string, unknown>): Promise<any> {
    return this.getFulfillmentDocuments(data);
  }

  async retrieveDocuments(
    fulfillmentData: Record<string, unknown>,
    documentType: string
  ): Promise<void> {
    if (documentType === "invoice") {
      return;
    }
    await this.getFulfillmentDocuments(fulfillmentData);
  }
}

export default InPostFulfillmentProviderService;
