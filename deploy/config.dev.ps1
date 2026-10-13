# Dev environment: the system as it runs today. Read by deploy-dev.ps1.
@{
    Name           = 'dev'
    SubscriptionId = '4f338a7a-f335-4d6a-9c7e-c0a53475f408'   # SUB-D1-EDS-DEV
    ResourceGroup  = 'rg-kietna-1422'
    Location       = 'centralus'

    FunctionApp = @{ Name = 'func-eds-dev' }

    Sql = @{ ServerName = 'sql-eds-dev1'; Database = 'eds-db' }

    # $(NAME) tokens that SQL scripts can use instead of environment-specific names.
    SqlTokens = [ordered]@{
        FUNC_APP         = 'func-eds-dev'
        BLOB_ACCOUNT_URL = 'https://stedsimages1008.blob.core.windows.net'
    }
    SqlReplace = [ordered]@{}

    Apim = @{
        Name              = 'apim-eds-dev'
        ApiId             = 'eds-data-api'
        Path              = 'eds'
        DisplayName       = 'EDS Data API'
        ServiceUrl        = 'https://apim-eds-dev.azure-api.net/eds'   # as live; the policy sets the real backend
        UrlNamedValue     = 'func-eds-url'
        KeyNamedValue     = 'func-eds-key'
        ManageNamedValues = $false   # dev's named values already exist and are left alone
        RateLimitPrefix   = ''
    }
}
