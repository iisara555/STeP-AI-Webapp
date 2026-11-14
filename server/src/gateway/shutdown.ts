export function gatewayShutdown(
  stopAccepting: () => void,
  shutdownRuntimes: () => Promise<void>,
  closeStores: () => void,
  exit: (code: number) => void,
  report: (error: unknown) => void = () => {},
) {
  let attempt: Promise<void> | undefined;
  return () => {
    if (attempt) return attempt;
    stopAccepting();
    attempt = (async () => {
      const errors: unknown[] = [];
      try {
        await shutdownRuntimes();
      } catch (error) {
        errors.push(error);
      }
      try {
        closeStores();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const error = errors.length === 1 ? errors[0] : new AggregateError(errors, 'GATEWAY_SHUTDOWN_FAILED');
        report(error);
        exit(1);
        throw error;
      }
      exit(0);
    })();
    return attempt;
  };
}
