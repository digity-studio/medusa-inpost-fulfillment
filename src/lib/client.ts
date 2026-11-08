import { MedusaError } from "@medusajs/framework/utils";
import {
  InPostAddress,
  InPostDispatchOrderResponse,
  InPostLabelFormat,
  InPostPluginOptions,
  InPostShipmentListResponse,
  InPostShipmentRequest,
  InPostShipmentResponse,
} from "./types";
import {
  decodeBody,
  fetchWithTimeout,
  resolveRequestTimeoutMs,
} from "./timeouts";

const SANDBOX_BASE_URL = "https://sandbox-api-shipx-pl.easypack24.net";
const PRODUCTION_BASE_URL = "https://api-shipx-pl.easypack24.net";

export class InPostShipXClient {
  private apiToken: string;
  private baseUrl: string;
  private organizationId: string;
  private requestTimeoutMs: number;

  constructor(options: InPostPluginOptions) {
    this.baseUrl = options.sandbox ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
    this.organizationId = options.organizationId;
    this.apiToken = options.apiToken;
    this.requestTimeoutMs = resolveRequestTimeoutMs(options);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    responseType: "json" | "buffer" = "json"
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };

    const { response, body: responseBody } = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      this.requestTimeoutMs,
      // Without the query: listShipments puts the receiver's e-mail there,
      // and this label ends up in the timeout error's message.
      `${method} ${path.split("?")[0]}`
    );

    if (!response.ok) {
      const errorText = decodeBody(responseBody);
      let errorMessage = `InPost API error: ${response.status} ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.details) {
          errorMessage += ` - ${JSON.stringify(errorJson.details)}`;
        } else if (errorJson.message) {
          errorMessage += ` - ${errorJson.message}`;
        } else if (errorJson.error) {
          errorMessage += ` - ${errorJson.error}`;
        } else {
          errorMessage += ` - ${errorText}`;
        }
      } catch {
        if (errorText) {
          errorMessage += ` - ${errorText}`;
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, errorMessage);
      }
      if (response.status === 404) {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, errorMessage);
      }
      if (response.status === 400 || response.status === 422) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, errorMessage);
      }
      if (response.status === 409) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, errorMessage);
      }
      if (response.status === 429) {
        throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, errorMessage);
      }

      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, errorMessage);
    }

    if (responseType === "buffer") {
      return responseBody as unknown as T;
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return JSON.parse(decodeBody(responseBody)) as T;
  }

  async createShipment(
    data: InPostShipmentRequest
  ): Promise<InPostShipmentResponse> {
    return this.request<InPostShipmentResponse>(
      "POST",
      `/v1/organizations/${this.organizationId}/shipments`,
      data
    );
  }

  async buyShipment(
    id: number,
    offerId: number
  ): Promise<InPostShipmentResponse> {
    return this.request<InPostShipmentResponse>(
      "POST",
      `/v1/shipments/${id}/buy`,
      { offer_id: offerId }
    );
  }

  async getShipment(id: number): Promise<InPostShipmentResponse> {
    return this.request<InPostShipmentResponse>(
      "GET",
      `/v1/shipments/${id}`
    );
  }

  /**
   * One page of the organization's shipments. `query` takes ShipX's list
   * filters as they are (`receiver_email`, `created_at_gteq`, `status`,
   * `page`, ...). There is no `reference` filter, so match it on the result.
   */
  async listShipments(
    query: Record<string, string | number> = {}
  ): Promise<InPostShipmentListResponse> {
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)])
    ).toString();

    return this.request<InPostShipmentListResponse>(
      "GET",
      `/v1/organizations/${this.organizationId}/shipments${params ? `?${params}` : ""}`
    );
  }

  async cancelShipment(id: number): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/v1/shipments/${id}`
    );
  }

  async getLabel(id: number, format: InPostLabelFormat = "pdf"): Promise<Buffer> {
    return this.request<Buffer>(
      "GET",
      `/v1/shipments/${id}/label?format=${format}`,
      undefined,
      "buffer"
    );
  }

  async createDispatchOrder(
    shipmentIds: number[],
    address: InPostAddress,
    comment?: string
  ): Promise<InPostDispatchOrderResponse> {
    return this.request<InPostDispatchOrderResponse>(
      "POST",
      `/v1/organizations/${this.organizationId}/dispatch_orders`,
      {
        shipments: shipmentIds,
        address,
        ...(comment && { comment }),
      }
    );
  }

}
