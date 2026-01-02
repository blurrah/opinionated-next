import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";

export function Link(props: ComponentPropsWithRef<typeof NextLink>) {
  return <NextLink {...props} />;
}
