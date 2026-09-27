CREATE FUNCTION public.reject_side_effect_manual_review_exit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user <> 'web_app' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'side_effect_manual_review_exit_requires_web_app';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  public.reject_side_effect_manual_review_exit()
  FROM PUBLIC;

CREATE TRIGGER side_effect_manual_review_exit_guard
BEFORE UPDATE ON public.side_effect_intent
FOR EACH ROW
WHEN (
  OLD.status = 'manual_review_required'
  AND NEW.status IS DISTINCT FROM OLD.status
)
EXECUTE FUNCTION public.reject_side_effect_manual_review_exit();
